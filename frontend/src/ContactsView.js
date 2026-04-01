import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import { mockData, enrichData } from './mockData';
import ContactForm from './ContactForm';
import EmailComposer from './EmailComposer';
import ContactMergeBanner from './ContactMergeBanner';
import { csvExport, EXPORT_COLUMNS } from './csvUtils';
import CSVImportModal from './CSVImportModal';
import { ContactOrgPosition } from './OrgChartPanel';
import './ContactsView.css';

// Fields that can be inline-edited on the contact detail panel
const EDITABLE_FIELDS = {
  first_name:       { label: 'First Name',       type: 'text',   required: true },
  last_name:        { label: 'Last Name',        type: 'text',   required: true },
  email:            { label: 'Email',            type: 'email',  required: true },
  phone:            { label: 'Phone',            type: 'tel' },
  title:            { label: 'Job Title',        type: 'text' },
  role_type:        { label: 'Role Type',        type: 'select', options: [
    { value: '',               label: 'No role' },
    { value: 'decision_maker', label: 'Decision Maker' },
    { value: 'influencer',     label: 'Influencer' },
    { value: 'champion',       label: 'Champion' },
    { value: 'blocker',        label: 'Blocker' },
    { value: 'end_user',       label: 'End User' },
    { value: 'economic_buyer', label: 'Economic Buyer' },
    { value: 'executive',      label: 'Executive' },
  ]},
  engagement_level: { label: 'Engagement',       type: 'select', options: [
    { value: 'low',    label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high',   label: 'High' },
  ]},
  location:         { label: 'Location',         type: 'text' },
  linkedin_url:     { label: 'LinkedIn',         type: 'url' },
  notes:            { label: 'Notes',            type: 'textarea' },
  reports_to_contact_id: { label: 'Reports To', type: 'reportsTo' },
};

function ContactsView({ openContactId = null, onContactOpened = null }) {
  const [contacts, setContacts] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [emails, setEmails] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingContact, setEditingContact] = useState(null);
  const [selectedContact, setSelectedContact] = useState(null);
  const [contactTeams, setContactTeams]       = useState([]);    // team memberships for selected contact
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  // Inline editing state
  const [editingField, setEditingField] = useState(null); // { field, value }
  const [savingField, setSavingField] = useState(null);

  // Email composer state
  const [showEmailComposer, setShowEmailComposer] = useState(false);
  const [emailComposerPrefill, setEmailComposerPrefill] = useState(null);
  const [showImportModal, setShowImportModal] = useState(false);

  // Deal suggestion snooze state
  const [snoozedSuggestions, setSnoozedSuggestions] = useState(() => {
    try {
      const stored = sessionStorage.getItem('contact_deal_snoozes');
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });

  // ── Scope toggle state ────────────────────────────────────────
  const [scope, setScope] = useState('mine');
  const [hasTeam, setHasTeam] = useState(false);

  useEffect(() => {
    apiService.orgAdmin.getMyTeam()
      .then(r => setHasTeam(r.data.hasTeam))
      .catch(() => setHasTeam(false));
  }, []);

  useEffect(() => { loadContacts(); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!openContactId || contacts.length === 0) return;
    const target = contacts.find(c => c.id === openContactId || c.id === parseInt(openContactId));
    if (target) {
      setSelectedContact(target);
      if (onContactOpened) onContactOpened();
    }
  }, [openContactId, contacts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset inline edit when switching contacts
  useEffect(() => { setEditingField(null); }, [selectedContact?.id]);

  // Load team memberships for selected contact
  useEffect(() => {
    if (!selectedContact?.id) { setContactTeams([]); return; }
    apiService.accountTeams.listByContact(selectedContact.id)
      .then(r => setContactTeams(r.data.memberships || []))
      .catch(() => setContactTeams([]));
  }, [selectedContact?.id]);

  const loadContacts = async () => {
    try {
      setLoading(true);
      setError('');
      const [contactsRes, accountsRes, dealsRes, meetingsRes] = await Promise.all([
        apiService.contacts.getAll(scope).catch(() => ({ data: { contacts: mockData.contacts } })),
        apiService.accounts.getAll(scope).catch(() => ({ data: { accounts: mockData.accounts } })),
        apiService.deals.getAll(scope).catch(() => ({ data: { deals: mockData.deals } })),
        apiService.meetings.getAll().catch(() => ({ data: { meetings: mockData.meetings } }))
      ]);
      const enrichedData = enrichData({
        accounts: accountsRes.data.accounts || accountsRes.data || [],
        contacts: contactsRes.data.contacts || contactsRes.data || [],
        deals:    dealsRes.data.deals       || dealsRes.data || [],
        emails:   [],
        meetings: meetingsRes.data.meetings || meetingsRes.data || [],
        actions: []
      });
      setContacts(enrichedData.contacts);
      setAccounts(enrichedData.accounts);
      setDeals(enrichedData.deals);

      setMeetings(enrichedData.meetings);
    } catch (err) {
      console.error('Error loading contacts:', err);
      setError('Failed to load contacts. Using sample data.');
      const enrichedData = enrichData({ ...mockData, actions: [] });
      setContacts(enrichedData.contacts);
      setAccounts(enrichedData.accounts);
      setDeals(enrichedData.deals);

      setMeetings(enrichedData.meetings);
    } finally {
      setLoading(false);
    }
  };

  // ── CRUD ────────────────────────────────────────────────────────────────

  const handleCreateContact = async (contactData) => {
    try {
      const response = await apiService.contacts.create(contactData);
      const newContact = response.data.contact || response.data;
      const account = accounts.find(a => a.id === newContact.account_id);
      setContacts([...contacts, { ...newContact, account }]);
      setShowForm(false);
      setError('');
    } catch (err) {
      console.error('Error creating contact:', err);
      setError(`Failed to create contact: ${err.response?.data?.error?.message || err.message}`);
    }
  };

  const handleUpdateContact = async (contactData) => {
    try {
      const response = await apiService.contacts.update(editingContact.id, contactData);
      const updated = response.data.contact || response.data;
      const account = accounts.find(a => a.id === updated.account_id);
      const enriched = { ...updated, account };
      setContacts(contacts.map(c => c.id === editingContact.id ? enriched : c));
      if (selectedContact?.id === editingContact.id) setSelectedContact(enriched);
      setEditingContact(null);
      setShowForm(false);
      setError('');
    } catch (err) {
      console.error('Error updating contact:', err);
      setError(`Failed to update contact: ${err.response?.data?.error?.message || err.message}`);
    }
  };

  const handleDeleteContact = async (contactId) => {
    if (!window.confirm('Are you sure you want to delete this contact?')) return;
    try {
      await apiService.contacts.delete(contactId);
    } catch {}
    setContacts(contacts.filter(c => c.id !== contactId));
    if (selectedContact?.id === contactId) setSelectedContact(null);
  };

  // ── Inline field save ───────────────────────────────────────────────────

  const handleInlineFieldSave = async (field, value) => {
    if (!selectedContact) return;
    setSavingField(field);
    try {
      // Map field names to what the backend expects (camelCase)
      const fieldMap = {
        first_name: 'firstName', last_name: 'lastName',
        email: 'email', phone: 'phone', title: 'title',
        role_type: 'roleType', engagement_level: 'engagementLevel',
        location: 'location', linkedin_url: 'linkedinUrl', notes: 'notes',
      };
      const payload = { [fieldMap[field] || field]: value };

      const response = await apiService.contacts.update(selectedContact.id, payload);
      const updated = response.data.contact || response.data;
      const account = accounts.find(a => a.id === (updated.account_id || selectedContact.account_id));
      const enriched = { ...selectedContact, ...updated, account };

      setContacts(prev => prev.map(c => c.id === selectedContact.id ? enriched : c));
      setSelectedContact(enriched);
    } catch (err) {
      console.error('Inline save error:', err);
      setError(`Failed to save: ${err.response?.data?.error?.message || err.message}`);
    } finally {
      setSavingField(null);
      setEditingField(null);
    }
  };

  // ── Deal helpers ────────────────────────────────────────────────────────

  const getLinkedDeals = (contact) => {
    if (!contact) return [];
    return (contact.deals || [])
      .map(ld => deals.find(d => d.id === ld.id) || ld)
      .filter(d => d && d.id);
  };

  const getUnlinkedAccountDeals = (contact) => {
    if (!contact) return [];
    const linkedIds = new Set((contact.deals || []).map(d => d.id));
    return deals.filter(d =>
      d.account_id === contact.account_id &&
      !linkedIds.has(d.id) &&
      d.stage !== 'closed_won' && d.stage !== 'closed_lost'
    );
  };

  const isSuggestionSnoozed = (contactId) => {
    const s = snoozedSuggestions[contactId];
    if (!s) return false;
    if (s === 'forever' || s === 'session') return true;
    if (typeof s === 'number' && Date.now() < s) return true;
    return false;
  };

  const handleSnoozeSuggestion = (contactId, duration) => {
    const map = { forever: 'forever', session: 'session', '7d': Date.now() + 7*864e5, '30d': Date.now() + 30*864e5 };
    const updated = { ...snoozedSuggestions, [contactId]: map[duration] || 'session' };
    setSnoozedSuggestions(updated);
    try { sessionStorage.setItem('contact_deal_snoozes', JSON.stringify(updated)); } catch {}
  };

  const handleTagContactToDeal = async (contactId, dealId) => {
    try {
      await apiService.dealContacts.add(dealId, contactId);
      await loadContacts();
    } catch (err) {
      console.error('Error tagging contact to deal:', err);
      setError(`Failed to link contact to deal: ${err.response?.data?.error?.message || err.message}`);
    }
  };

  const handleExportCSV = () => {
    csvExport(contacts, EXPORT_COLUMNS.contacts, `contacts-${scope}-${new Date().toISOString().slice(0,10)}.csv`);
  };

  const handleImportContacts = async (rows) => {
    const response = await apiService.contacts.bulk(rows);
    const result = response.data;
    if (result.imported > 0) loadContacts();
    return result;
  };

  // ── Email / Meeting helpers ─────────────────────────────────────────────

  const getContactEmails = (contactId) =>
    emails.filter(e => e.contact_id === contactId)
      .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));

  const getContactMeetings = (contactId) => {
    const contact = contacts.find(c => c.id === contactId);
    if (!contact) return [];
    const linkedDealIds = new Set((contact.deals || []).map(d => d.id));
    return meetings.filter(m => {
      if (m.contact_id === contactId) return true;
      if (contact.email && m.attendees) {
        const str = typeof m.attendees === 'string' ? m.attendees : JSON.stringify(m.attendees || []);
        if (str.toLowerCase().includes(contact.email.toLowerCase())) return true;
      }
      if (m.deal_id && linkedDealIds.has(m.deal_id)) return true;
      return false;
    }).sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  };

  // ── Navigation ──────────────────────────────────────────────────────────

  const nav = (tab, extra) =>
    window.dispatchEvent(new CustomEvent('navigate', { detail: { tab, ...extra } }));

  const openEmailComposer = (contact) => {
    setEmailComposerPrefill({ contactId: contact.id, dealId: '', subject: '', body: '', toAddress: contact.email });
    setShowEmailComposer(true);
  };

  const handleSendEmail = async (emailData) => {
    try {
      const response = await apiService.emails.send(emailData);

      return response.data;
    } catch (err) {
      console.error('Send email error:', err);
      throw err;
    }
  };

  // ── Filter + group ──────────────────────────────────────────────────────

  const filteredContacts = contacts.filter(contact => {
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    return (
      contact.first_name?.toLowerCase().includes(s) ||
      contact.last_name?.toLowerCase().includes(s) ||
      contact.email?.toLowerCase().includes(s) ||
      contact.title?.toLowerCase().includes(s) ||
      contact.account?.name?.toLowerCase().includes(s)
    );
  });

  const groupedContacts = {
    high:   filteredContacts.filter(c => c.engagement_level === 'high'),
    medium: filteredContacts.filter(c => c.engagement_level === 'medium'),
    low:    filteredContacts.filter(c => c.engagement_level === 'low'),
  };

  // ── Render helpers for inline editable fields ───────────────────────────

  const renderEditableField = (field, contact) => {
    const cfg = EDITABLE_FIELDS[field];
    if (!cfg) return null;
    const currentValue = contact[field] || '';
    const isEditing = editingField?.field === field;

    // Select fields
    if (cfg.type === 'select') {
      if (isEditing) {
        return (
          <select
            className="inline-edit-select"
            autoFocus
            value={editingField.value}
            onChange={e => handleInlineFieldSave(field, e.target.value)}
            onBlur={() => setEditingField(null)}
            onKeyDown={e => e.key === 'Escape' && setEditingField(null)}
          >
            {cfg.options.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        );
      }
      // Display value
      if (field === 'role_type' && currentValue) {
        return (
          <span
            className={`detail-badge role-${currentValue} detail-value--editable`}
            onClick={() => setEditingField({ field, value: currentValue })}
            title="Click to edit"
          >
            {currentValue.replace(/_/g, ' ')} ✏️
          </span>
        );
      }
      if (field === 'engagement_level') {
        return (
          <span
            className={`detail-badge engagement-${currentValue} detail-value--editable`}
            onClick={() => setEditingField({ field, value: currentValue })}
            title="Click to edit"
          >
            {currentValue} engagement ✏️
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
    }

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
              onKeyDown={e => {
                if (e.key === 'Escape') setEditingField(null);
              }}
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
          className="detail-value--editable contact-notes-text"
          onClick={() => setEditingField({ field, value: currentValue })}
          title="Click to edit"
        >
          {currentValue || 'Add notes…'} ✏️
        </span>
      );
    }

    // Text / email / tel / url / date
    if (isEditing) {
      return (
        <div className="inline-edit-row">
          <input
            className="inline-edit-input"
            type={cfg.type}
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

    // Display value — special rendering for links
    if (field === 'email' && currentValue) {
      return (
        <span className="inline-display-row">
          <a href={`mailto:${currentValue}`}>{currentValue}</a>
          <button className="inline-edit-trigger" onClick={() => setEditingField({ field, value: currentValue })} title="Edit">✏️</button>
        </span>
      );
    }
    if (field === 'phone' && currentValue) {
      return (
        <span className="inline-display-row">
          <a href={`tel:${currentValue}`}>{currentValue}</a>
          <button className="inline-edit-trigger" onClick={() => setEditingField({ field, value: currentValue })} title="Edit">✏️</button>
        </span>
      );
    }
    if (field === 'linkedin_url' && currentValue) {
      return (
        <span className="inline-display-row">
          <a href={currentValue} target="_blank" rel="noopener noreferrer">View Profile →</a>
          <button className="inline-edit-trigger" onClick={() => setEditingField({ field, value: currentValue })} title="Edit">✏️</button>
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
      <div className="contacts-view">
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading contacts...</p>
        </div>
      </div>
    );
  }

  // ── Main render ─────────────────────────────────────────────────────────

  return (
    <div className="contacts-view">
      {/* Header */}
      <div className="contacts-header">
        <div>
          <h1>Contacts</h1>
          <p className="contacts-subtitle">
            {contacts.length} contact{contacts.length !== 1 ? 's' : ''} in your CRM
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
                  {s === 'mine' ? 'My Contacts' : s === 'team' ? 'My Team' : 'All Org'}
                </button>
              ))}
            </div>
          )}
          <button className="btn-primary" onClick={() => setShowForm(true)}>
            + New Contact
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

      {/* Duplicate Contacts Banner */}
      <ContactMergeBanner onMergeComplete={loadContacts} />

      {/* Search */}
      <div className="search-bar">
        <input
          type="text"
          placeholder="Search contacts by name, email, title, or company..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="search-input"
        />
        {searchTerm && (
          <button className="clear-search" onClick={() => setSearchTerm('')}>✕</button>
        )}
      </div>

      {/* Stats */}
      <div className="contacts-stats">
        <div className="stat-card">
          <div className="stat-value">{groupedContacts.high.length}</div>
          <div className="stat-label">High Engagement</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{groupedContacts.medium.length}</div>
          <div className="stat-label">Medium Engagement</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{groupedContacts.low.length}</div>
          <div className="stat-label">Low Engagement</div>
        </div>
      </div>

      {/* Contacts Container */}
      <div className="contacts-container">
        {/* Cards */}
        <div className="contacts-list">
          {filteredContacts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">👥</div>
              <h3>{searchTerm ? 'No contacts found' : 'No contacts yet'}</h3>
              <p>{searchTerm ? 'Try a different search term' : 'Create your first contact to start building relationships'}</p>
              {!searchTerm && (
                <button className="btn-primary" onClick={() => setShowForm(true)}>+ Create Contact</button>
              )}
            </div>
          ) : (
            filteredContacts.map(contact => (
              <ContactCard
                key={contact.id}
                contact={contact}
                linkedDeals={getLinkedDeals(contact)}
                onEdit={() => { setEditingContact(contact); setShowForm(true); }}
                onDelete={() => handleDeleteContact(contact.id)}
                onSelect={() => setSelectedContact(contact)}
                isSelected={selectedContact?.id === contact.id}
              />
            ))
          )}
        </div>

        {/* Contact Detail Panel */}
        {selectedContact && (
          <div className="contact-detail-panel panel-fullscreen">
            <div className="panel-header">
              <h2>{selectedContact.first_name} {selectedContact.last_name}{selectedContact.title ? ` — ${selectedContact.title}` : ''}</h2>
              <div className="panel-header-actions">
                <button className="close-panel" onClick={() => setSelectedContact(null)}>×</button>
              </div>
            </div>

            <div className="panel-content">

              {/* ── 1. Contact Information (all fields inline-editable) ── */}
              <div className="detail-section">
                <div className="detail-section-header">
                  <h3>📋 Contact Information</h3>
                </div>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">First Name</span>
                    {renderEditableField('first_name', selectedContact)}
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Last Name</span>
                    {renderEditableField('last_name', selectedContact)}
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Email</span>
                    {renderEditableField('email', selectedContact)}
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Phone</span>
                    {renderEditableField('phone', selectedContact)}
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Job Title</span>
                    {renderEditableField('title', selectedContact)}
                  </div>

                  {/* Company — clickable navigation (not inline-editable here) */}
                  {selectedContact.account && (
                    <div className="detail-item">
                      <span className="detail-label">Company</span>
                      <span
                        className="detail-value--link"
                        onClick={() => nav('accounts', { accountId: selectedContact.account_id || selectedContact.account.id })}
                        title="Open company page"
                      >
                        {selectedContact.account.name} →
                      </span>
                    </div>
                  )}

                  <div className="detail-item">
                    <span className="detail-label">Role Type</span>
                    {renderEditableField('role_type', selectedContact)}
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Engagement</span>
                    {renderEditableField('engagement_level', selectedContact)}
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Location</span>
                    {renderEditableField('location', selectedContact)}
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">LinkedIn</span>
                    {renderEditableField('linkedin_url', selectedContact)}
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Reports To</span>
                    <ReportsToField
                      contact={selectedContact}
                      accountContacts={contacts.filter(c =>
                        c.account_id === selectedContact.account_id && c.id !== selectedContact.id
                      )}
                      onSave={async (managerId) => {
                        try {
                          await apiService.orgHierarchy.setReportsTo(selectedContact.id, managerId);
                          setSelectedContact(prev => ({ ...prev, reports_to_contact_id: managerId }));
                          setContacts(prev => prev.map(c =>
                            c.id === selectedContact.id ? { ...c, reports_to_contact_id: managerId } : c
                          ));
                        } catch (err) {
                          console.error('ReportsTo save error:', err);
                        }
                      }}
                    />
                  </div>
                  {selectedContact.last_contact_date && (
                    <div className="detail-item">
                      <span className="detail-label">Last Contact</span>
                      <span>{new Date(selectedContact.last_contact_date).toLocaleDateString()}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* ── 1b. Org Chart Position ───────────────────────────── */}
              {selectedContact.account_id && (
                <div className="detail-section">
                  <h3>🌳 Org Chart Position</h3>
                  <ContactOrgPosition
                    contactId={selectedContact.id}
                    accountId={selectedContact.account_id}
                    onNavigateToContact={(contactId) => {
                      const target = contacts.find(c => c.id === contactId);
                      if (target) setSelectedContact(target);
                    }}
                    onViewFullChart={() =>
                      nav('accounts', { accountId: selectedContact.account_id })
                    }
                  />
                </div>
              )}

              {/* ── 1c. Customer Team Memberships ──────────────── */}
              {contactTeams.length > 0 && (
                <div className="detail-section">
                  <h3>👥 Customer Teams ({contactTeams.length})</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {contactTeams.map(m => (
                      <div key={m.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '7px 10px', background: '#f8fafc',
                        border: '1px solid #e5e7eb', borderRadius: 6,
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
                            {m.teamName}
                          </div>
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }}>
                            {m.accountName}
                            {m.teamDimension && m.teamDimension !== 'custom' && (
                              <span style={{ marginLeft: 6, padding: '1px 5px', background: '#e0f2fe', color: '#0369a1', borderRadius: 4, fontSize: 10, fontWeight: 600 }}>
                                {m.teamDimension}
                              </span>
                            )}
                          </div>
                        </div>
                        <span style={{
                          fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
                          background: '#f1f5f9', color: '#374151',
                        }}>
                          {m.role?.charAt(0).toUpperCase() + m.role?.slice(1) || 'Member'}
                        </span>
                        {m.isPrimary && (
                          <span style={{ fontSize: 10, color: '#0369a1', fontWeight: 700 }}>★</span>
                        )}
                        <button
                          onClick={() => nav('accounts', { accountId: m.accountId })}
                          title="Open account"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#6b7280' }}>
                          →
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── 2. Related Deals ──────────────────────────────── */}
              <div className="detail-section">
                <h3>💼 Related Deals ({getLinkedDeals(selectedContact).length})</h3>
                {getLinkedDeals(selectedContact).length === 0 ? (
                  <p className="empty-message">No deal roles assigned to this contact</p>
                ) : (
                  <div className="linked-items-list">
                    {getLinkedDeals(selectedContact).map(deal => (
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
                            {deal.value ? `$${parseFloat(deal.value).toLocaleString()}` : ''}
                            {deal.value && deal.stage ? ' · ' : ''}
                            {deal.stage}
                          </div>
                        </div>
                        <span className="item-arrow">→</span>
                      </div>
                    ))}
                  </div>
                )}

                {!isSuggestionSnoozed(selectedContact.id) &&
                 getUnlinkedAccountDeals(selectedContact).length > 0 && (
                  <DealSuggestionBanner
                    contact={selectedContact}
                    unlinkedDeals={getUnlinkedAccountDeals(selectedContact)}
                    onTag={(dealId) => handleTagContactToDeal(selectedContact.id, dealId)}
                    onSnooze={(duration) => handleSnoozeSuggestion(selectedContact.id, duration)}
                  />
                )}
              </div>

              {/* ── 3. Email Activity (sent vs received) ──────────── */}
              <div className="detail-section">
                <h3>📧 Email Activity ({getContactEmails(selectedContact.id).length})</h3>
                {getContactEmails(selectedContact.id).length === 0 ? (
                  <p className="empty-message">No email history</p>
                ) : (
                  <div className="linked-items-list">
                    {getContactEmails(selectedContact.id).slice(0, 15).map(em => {
                      const isSent = em.direction === 'sent';
                      return (
                        <div key={em.id} className={`linked-item email-item email-item--${isSent ? 'sent' : 'received'}`}>
                          <span className="item-icon">{isSent ? '📤' : '📥'}</span>
                          <div className="item-info">
                            <div className="item-name">
                              <span className={`email-direction-badge email-direction-badge--${isSent ? 'sent' : 'received'}`}>
                                {isSent ? 'Sent' : 'Received'}
                              </span>
                              {em.subject || '(No subject)'}
                            </div>
                            <div className="item-meta">
                              {new Date(em.sent_at).toLocaleDateString(undefined, {
                                month: 'short', day: 'numeric', year: 'numeric',
                                hour: '2-digit', minute: '2-digit'
                              })}
                              {isSent && em.opened_at && (
                                <span className="email-opened-badge">Opened</span>
                              )}
                              {em.deal_id && (() => {
                                const d = deals.find(x => x.id === em.deal_id);
                                return d ? <span className="email-deal-tag">{d.name}</span> : '';
                              })()}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {getContactEmails(selectedContact.id).length > 15 && (
                      <div className="show-more-hint">
                        +{getContactEmails(selectedContact.id).length - 15} more emails
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── 4. Meetings ────────────────────────────────────── */}
              <div className="detail-section">
                <h3>📅 Meetings ({getContactMeetings(selectedContact.id).length})</h3>
                {getContactMeetings(selectedContact.id).length === 0 ? (
                  <p className="empty-message">No meetings on record</p>
                ) : (
                  <div className="linked-items-list">
                    {getContactMeetings(selectedContact.id).map(m => {
                      const isPast = new Date(m.start_time) < new Date();
                      return (
                        <div
                          key={m.id}
                          className="linked-item linked-item--clickable"
                          onClick={() => nav('calendar', { meetingId: m.id })}
                          title="View in Calendar"
                        >
                          <span className="item-icon">{isPast ? '✅' : '📅'}</span>
                          <div className="item-info">
                            <div className="item-name">{m.title || 'Meeting'}</div>
                            <div className="item-meta">
                              {new Date(m.start_time).toLocaleDateString(undefined, {
                                month: 'short', day: 'numeric', year: 'numeric',
                                hour: '2-digit', minute: '2-digit'
                              })}
                              {' · '}
                              <span className={`meeting-status meeting-status--${m.status}`}>{m.status}</span>
                            </div>
                          </div>
                          <span className="item-arrow">→</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── 5. Notes (inline-editable) ─────────────────────── */}
              <div className="detail-section">
                <h3>📝 Notes</h3>
                {renderEditableField('notes', selectedContact)}
              </div>

              {/* ── 5b. Prospecting Origin ─────────────────────────── */}
              {selectedContact.converted_from_prospect_id && (
                <div className="detail-section">
                  <h3>🎯 Prospecting Origin</h3>
                  <div style={{
                    padding: '10px 14px', background: '#f0fdfa', borderRadius: '8px',
                    border: '1px solid #99f6e4', display: 'flex', alignItems: 'center',
                    gap: '8px', cursor: 'pointer',
                  }}
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'prospecting' } }));
                  }}
                  >
                    <span style={{ fontSize: '16px' }}>🎯</span>
                    <div>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: '#0F9D8E' }}>
                        Converted from Prospect #{selectedContact.converted_from_prospect_id}
                      </span>
                      <span style={{ display: 'block', fontSize: '11px', color: '#6b7280' }}>
                        Click to view prospecting history →
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* ── 6. Quick Actions ───────────────────────────────── */}
              <div className="detail-section">
                <h3>⚡ Quick Actions</h3>
                <div className="quick-actions">
                  <button className="btn-action" onClick={() => openEmailComposer(selectedContact)}>
                    ✉️ Send Email
                  </button>
                  {selectedContact.phone && (
                    <a href={`tel:${selectedContact.phone}`} className="btn-action">📞 Call Contact</a>
                  )}
                  {selectedContact.linkedin_url && (
                    <a href={selectedContact.linkedin_url} target="_blank" rel="noopener noreferrer" className="btn-action">
                      💼 View LinkedIn
                    </a>
                  )}
                  <button className="btn-action btn-action--danger" onClick={() => handleDeleteContact(selectedContact.id)}>
                    🗑️ Delete Contact
                  </button>
                </div>
              </div>

            </div>
          </div>
        )}
      </div>

      {/* Contact Form Modal */}
      {(showForm || editingContact) && (
        <ContactForm
          contact={editingContact}
          accounts={accounts}
          onSubmit={editingContact ? handleUpdateContact : handleCreateContact}
          onClose={() => { setShowForm(false); setEditingContact(null); }}
        />
      )}

      {/* Email Composer Modal */}
      {showEmailComposer && (
        <EmailComposer
          contacts={contacts}
          deals={deals}
          prefill={emailComposerPrefill}
          onSubmit={handleSendEmail}
          onClose={() => { setShowEmailComposer(false); setEmailComposerPrefill(null); }}
        />
      )}

      {/* CSV Import Modal */}
      {showImportModal && (
        <CSVImportModal
          entity="contacts"
          accounts={accounts}
          onImport={handleImportContacts}
          onClose={() => setShowImportModal(false)}
        />
      )}
    </div>
  );
}


// ── Deal Suggestion Banner ────────────────────────────────────────────────────

function DealSuggestionBanner({ contact, unlinkedDeals, onTag, onSnooze }) {
  const [showSnoozeOptions, setShowSnoozeOptions] = useState(false);
  const [taggingDealId, setTaggingDealId] = useState(null);

  const handleTag = async (dealId) => {
    setTaggingDealId(dealId);
    try { await onTag(dealId); } finally { setTaggingDealId(null); }
  };

  return (
    <div className="deal-suggestion-banner">
      <div className="deal-suggestion-header">
        <span className="deal-suggestion-icon">💡</span>
        <span className="deal-suggestion-text">
          {contact.account?.name || 'This account'} has {unlinkedDeals.length} open
          deal{unlinkedDeals.length !== 1 ? 's' : ''} where {contact.first_name} isn't linked
        </span>
      </div>
      <div className="deal-suggestion-list">
        {unlinkedDeals.map(deal => (
          <div key={deal.id} className="deal-suggestion-item">
            <div className="deal-suggestion-item-info">
              <span className="deal-suggestion-item-name">{deal.name}</span>
              <span className="deal-suggestion-item-meta">
                {deal.value ? `$${parseFloat(deal.value).toLocaleString()}` : ''} · {deal.stage}
              </span>
            </div>
            <button className="btn-tag-deal" onClick={() => handleTag(deal.id)} disabled={taggingDealId === deal.id}>
              {taggingDealId === deal.id ? 'Linking…' : '+ Link'}
            </button>
          </div>
        ))}
      </div>
      <div className="deal-suggestion-dismiss">
        {!showSnoozeOptions ? (
          <button className="btn-dismiss-link" onClick={() => setShowSnoozeOptions(true)}>Dismiss</button>
        ) : (
          <div className="snooze-options">
            <span className="snooze-label">Dismiss for:</span>
            <button className="btn-snooze" onClick={() => onSnooze('session')}>This session</button>
            <button className="btn-snooze" onClick={() => onSnooze('7d')}>7 days</button>
            <button className="btn-snooze" onClick={() => onSnooze('30d')}>30 days</button>
            <button className="btn-snooze" onClick={() => onSnooze('forever')}>Forever</button>
            <button className="btn-snooze btn-snooze--cancel" onClick={() => setShowSnoozeOptions(false)}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}


// ── Contact Card ──────────────────────────────────────────────────────────────

function ContactCard({ contact, linkedDeals, onEdit, onDelete, onSelect, isSelected }) {
  const account = contact.account || { name: 'Unknown Company' };
  const activeDeals = linkedDeals.filter(d => d.stage !== 'closed_won' && d.stage !== 'closed_lost');

  return (
    <div className={`contact-card ${isSelected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="contact-card-header">
        <div className="contact-avatar">
          {contact.first_name?.[0]}{contact.last_name?.[0]}
        </div>
        <div className="contact-actions">
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }} className="icon-btn" title="Edit">✏️</button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="icon-btn" title="Delete">🗑️</button>
        </div>
      </div>
      <h3 className="contact-name">{contact.first_name} {contact.last_name}</h3>
      {contact.title && <p className="contact-title">{contact.title}</p>}
      <p className="contact-company">{account.name}</p>
      <div className="contact-meta">
        <span className="contact-email">✉️ {contact.email}</span>
        {contact.phone && <span className="contact-phone">📞 {contact.phone}</span>}
      </div>
      {contact.role_type && (
        <div className={`contact-role role-${contact.role_type}`}>
          {contact.role_type.replace(/_/g, ' ')}
        </div>
      )}
      <div className="contact-footer">
        <span className={`engagement-badge ${contact.engagement_level}`}>
          {contact.engagement_level} engagement
        </span>
        <span className="deals-count">
          {activeDeals.length} active deal{activeDeals.length !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}

// ── ReportsToField — inline "Reports To" picker on Contact detail panel ──────

function ReportsToField({ contact, accountContacts, onSave }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const manager = accountContacts.find(c => c.id === contact.reports_to_contact_id);

  const handleChange = async (e) => {
    const newManagerId = e.target.value ? parseInt(e.target.value) : null;
    setSaving(true);
    try {
      await onSave(newManagerId);
    } catch (err) {
      console.error('ReportsTo save error:', err);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <select
        className="inline-edit-select"
        autoFocus
        defaultValue={contact.reports_to_contact_id || ''}
        onChange={handleChange}
        onBlur={() => setEditing(false)}
        disabled={saving}
        style={{
          padding: '6px 10px', border: '1.5px solid #6366f1', borderRadius: '6px',
          fontSize: '14px', fontFamily: 'inherit', outline: 'none',
          background: '#fff', boxShadow: '0 0 0 2px rgba(99,102,241,.12)',
        }}
      >
        <option value="">— No manager (root) —</option>
        {accountContacts.map(c => (
          <option key={c.id} value={c.id}>
            {c.first_name} {c.last_name}{c.title ? ` · ${c.title}` : ''}
          </option>
        ))}
      </select>
    );
  }

  return (
    <span
      className="detail-value--editable"
      onClick={() => !saving && setEditing(true)}
      title="Click to change reporting line"
    >
      {saving
        ? 'Saving…'
        : manager
          ? `${manager.first_name} ${manager.last_name}${manager.title ? ` (${manager.title})` : ''} ✏️`
          : <span style={{ color: '#94a3b8' }}>Not set ✏️</span>
      }
    </span>
  );
}


export default ContactsView;
