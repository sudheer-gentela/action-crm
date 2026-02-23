import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import { mockData, enrichData } from './mockData';
import ContactForm from './ContactForm';
import EmailComposer from './EmailComposer';
import './ContactsView.css';

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
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  // Email composer state
  const [showEmailComposer, setShowEmailComposer] = useState(false);
  const [emailComposerPrefill, setEmailComposerPrefill] = useState(null);

  // Deal suggestion snooze state — keyed by contact id
  const [snoozedSuggestions, setSnoozedSuggestions] = useState(() => {
    try {
      const stored = sessionStorage.getItem('contact_deal_snoozes');
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });

  useEffect(() => {
    loadContacts();
  }, []);

  // Auto-open a specific contact when navigated from another view
  useEffect(() => {
    if (!openContactId || contacts.length === 0) return;
    const target = contacts.find(c => c.id === openContactId || c.id === parseInt(openContactId));
    if (target) {
      setSelectedContact(target);
      if (onContactOpened) onContactOpened();
    }
  }, [openContactId, contacts]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadContacts = async () => {
    try {
      setLoading(true);
      setError('');

      const [contactsRes, accountsRes, dealsRes, emailsRes, meetingsRes] = await Promise.all([
        apiService.contacts.getAll().catch(() => ({ data: { contacts: mockData.contacts } })),
        apiService.accounts.getAll().catch(() => ({ data: { accounts: mockData.accounts } })),
        apiService.deals.getAll().catch(() => ({ data: { deals: mockData.deals } })),
        apiService.emails.getAll().catch(() => ({ data: { emails: mockData.emails } })),
        apiService.meetings.getAll().catch(() => ({ data: { meetings: mockData.meetings } }))
      ]);

      const enrichedData = enrichData({
        accounts: accountsRes.data.accounts || accountsRes.data || [],
        contacts: contactsRes.data.contacts || contactsRes.data || [],
        deals: dealsRes.data.deals || dealsRes.data || [],
        emails: emailsRes.data.emails || emailsRes.data || [],
        meetings: meetingsRes.data.meetings || meetingsRes.data || [],
        actions: []
      });

      setContacts(enrichedData.contacts);
      setAccounts(enrichedData.accounts);
      setDeals(enrichedData.deals);
      setEmails(enrichedData.emails);
      setMeetings(enrichedData.meetings);

    } catch (err) {
      console.error('Error loading contacts:', err);
      setError('Failed to load contacts. Using sample data.');
      
      const enrichedData = enrichData({
        ...mockData,
        actions: []
      });
      
      setContacts(enrichedData.contacts);
      setAccounts(enrichedData.accounts);
      setDeals(enrichedData.deals);
      setEmails(enrichedData.emails);
      setMeetings(enrichedData.meetings);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateContact = async (contactData) => {
    try {
      console.log('🔵 Creating contact with data:', contactData);
      const response = await apiService.contacts.create(contactData);
      console.log('✅ Contact created successfully:', response.data);
      const newContact = response.data.contact || response.data;
      const account = accounts.find(a => a.id === newContact.account_id);
      const enrichedContact = { ...newContact, account };
      setContacts([...contacts, enrichedContact]);
      setShowForm(false);
      setError('');
    } catch (err) {
      console.error('❌ Error creating contact:', err);
      setError(`Failed to create contact: ${err.response?.data?.error?.message || err.message}`);
    }
  };

  const handleUpdateContact = async (contactData) => {
    try {
      console.log('🔵 Updating contact:', editingContact.id, 'with data:', contactData);
      const response = await apiService.contacts.update(editingContact.id, contactData);
      console.log('✅ Contact updated successfully:', response.data);
      const updatedContact = response.data.contact || response.data;
      const account = accounts.find(a => a.id === updatedContact.account_id);
      const enrichedContact = { ...updatedContact, account };
      setContacts(contacts.map(c => c.id === editingContact.id ? enrichedContact : c));
      // Update selected contact if it's the one being edited
      if (selectedContact?.id === editingContact.id) {
        setSelectedContact(enrichedContact);
      }
      setEditingContact(null);
      setShowForm(false);
      setError('');
    } catch (err) {
      console.error('❌ Error updating contact:', err);
      setError(`Failed to update contact: ${err.response?.data?.error?.message || err.message}`);
    }
  };

  const handleDeleteContact = async (contactId) => {
    if (!window.confirm('Are you sure you want to delete this contact?')) return;
    try {
      await apiService.contacts.delete(contactId);
      setContacts(contacts.filter(c => c.id !== contactId));
      if (selectedContact?.id === contactId) setSelectedContact(null);
      setError('');
    } catch (err) {
      console.error('Error deleting contact:', err);
      setContacts(contacts.filter(c => c.id !== contactId));
      if (selectedContact?.id === contactId) setSelectedContact(null);
    }
  };

  // ── Deal lookup helpers ──────────────────────────────────────────────────

  // Primary: deals where the contact has a role (from deal_contacts join)
  const getLinkedDeals = (contact) => {
    if (!contact) return [];
    const linked = contact.deals || [];
    return linked
      .map(ld => {
        const fullDeal = deals.find(d => d.id === ld.id);
        return fullDeal || ld;
      })
      .filter(d => d && d.id);
  };

  // Secondary: unlinked account deals — open deals on same account where contact has no role
  const getUnlinkedAccountDeals = (contact) => {
    if (!contact) return [];
    const linkedIds = new Set((contact.deals || []).map(d => d.id));
    return deals.filter(d =>
      d.account_id === contact.account_id &&
      !linkedIds.has(d.id) &&
      d.stage !== 'closed_won' &&
      d.stage !== 'closed_lost'
    );
  };

  const isSuggestionSnoozed = (contactId) => {
    const snooze = snoozedSuggestions[contactId];
    if (!snooze) return false;
    if (snooze === 'forever') return true;
    if (snooze === 'session') return true;
    if (typeof snooze === 'number' && Date.now() < snooze) return true;
    return false;
  };

  const handleSnoozeSuggestion = (contactId, duration) => {
    let value;
    if (duration === 'forever') value = 'forever';
    else if (duration === 'session') value = 'session';
    else if (duration === '7d') value = Date.now() + 7 * 24 * 60 * 60 * 1000;
    else if (duration === '30d') value = Date.now() + 30 * 24 * 60 * 60 * 1000;
    else value = 'session';

    const updated = { ...snoozedSuggestions, [contactId]: value };
    setSnoozedSuggestions(updated);
    try { sessionStorage.setItem('contact_deal_snoozes', JSON.stringify(updated)); } catch {}
  };

  const getContactEmails = (contactId) => {
    return emails.filter(e => e.contact_id === contactId)
      .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
  };

  const getContactMeetings = (contactId) => {
    const contact = contacts.find(c => c.id === contactId);
    if (!contact) return [];
    const linkedDealIds = new Set((contact.deals || []).map(d => d.id));

    return meetings.filter(m => {
      if (m.contact_id === contactId) return true;
      if (contact.email && m.attendees) {
        const attendeeStr = typeof m.attendees === 'string'
          ? m.attendees.toLowerCase()
          : JSON.stringify(m.attendees || []).toLowerCase();
        if (attendeeStr.includes(contact.email.toLowerCase())) return true;
      }
      if (m.deal_id && linkedDealIds.has(m.deal_id)) return true;
      return false;
    }).sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  };

  // ── Navigation ──────────────────────────────────────────────────────────

  const navigateToAccount = (accountId) => {
    window.dispatchEvent(new CustomEvent('navigate', {
      detail: { tab: 'accounts', accountId }
    }));
  };

  const navigateToDeal = (dealId) => {
    window.dispatchEvent(new CustomEvent('navigate', {
      detail: { tab: 'deals', dealId }
    }));
  };

  const navigateToMeeting = (meetingId) => {
    window.dispatchEvent(new CustomEvent('navigate', {
      detail: { tab: 'calendar', meetingId }
    }));
  };

  // ── Email composer ──────────────────────────────────────────────────────

  const openEmailComposer = (contact) => {
    setEmailComposerPrefill({
      contactId: contact.id,
      dealId: '',
      subject: '',
      body: '',
      toAddress: contact.email,
    });
    setShowEmailComposer(true);
  };

  const handleSendEmail = async (emailData) => {
    try {
      // emailData comes from EmailComposer: { contact_id, deal_id, subject, body, toAddress, actionId }
      const response = await apiService.emails.send(emailData);
      // Reload emails to reflect the new one
      try {
        const emailsRes = await apiService.emails.getAll();
        const updatedEmails = emailsRes.data.emails || emailsRes.data || [];
        setEmails(updatedEmails);
      } catch {}
      return response.data;
    } catch (err) {
      console.error('Send email error:', err);
      throw err;
    }
  };

  // ── Tag contact to deal ─────────────────────────────────────────────────

  const handleTagContactToDeal = async (contactId, dealId) => {
    try {
      await apiService.dealContacts.add(dealId, contactId);
      // Reload contacts to refresh the deals array from deal_contacts join
      await loadContacts();
    } catch (err) {
      console.error('Error tagging contact to deal:', err);
      setError(`Failed to link contact to deal: ${err.response?.data?.error?.message || err.message}`);
    }
  };

  // ── Filter + group ──────────────────────────────────────────────────────

  const filteredContacts = contacts.filter(contact => {
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    return (
      contact.first_name?.toLowerCase().includes(search) ||
      contact.last_name?.toLowerCase().includes(search) ||
      contact.email?.toLowerCase().includes(search) ||
      contact.title?.toLowerCase().includes(search) ||
      contact.account?.name?.toLowerCase().includes(search)
    );
  });

  const groupedContacts = {
    high: filteredContacts.filter(c => c.engagement_level === 'high'),
    medium: filteredContacts.filter(c => c.engagement_level === 'medium'),
    low: filteredContacts.filter(c => c.engagement_level === 'low')
  };

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

  return (
    <div className="contacts-view">
      {/* Header */}
      <div className="contacts-header">
        <div>
          <h1>Contacts</h1>
          <p className="contacts-subtitle">
            {contacts.length} contact{contacts.length !== 1 ? 's' : ''} in your CRM
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm(true)}>
          + New Contact
        </button>
      </div>

      {error && (
        <div className="info-banner">
          ℹ️ {error}
        </div>
      )}

      {/* Search Bar */}
      <div className="search-bar">
        <input
          type="text"
          placeholder="Search contacts by name, email, title, or company..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="search-input"
        />
        {searchTerm && (
          <button className="clear-search" onClick={() => setSearchTerm('')}>
            ✕
          </button>
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
      <div className={`contacts-container ${selectedContact ? 'with-panel' : ''}`}>
        {/* Contacts List */}
        <div className="contacts-list">
          {filteredContacts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">👥</div>
              <h3>{searchTerm ? 'No contacts found' : 'No contacts yet'}</h3>
              <p>
                {searchTerm 
                  ? 'Try a different search term'
                  : 'Create your first contact to start building relationships'}
              </p>
              {!searchTerm && (
                <button className="btn-primary" onClick={() => setShowForm(true)}>
                  + Create Contact
                </button>
              )}
            </div>
          ) : (
            filteredContacts.map(contact => (
              <ContactCard
                key={contact.id}
                contact={contact}
                linkedDeals={getLinkedDeals(contact)}
                onEdit={() => setEditingContact(contact)}
                onDelete={() => handleDeleteContact(contact.id)}
                onSelect={() => setSelectedContact(contact)}
                isSelected={selectedContact?.id === contact.id}
              />
            ))
          )}
        </div>

        {/* Contact Detail Panel */}
        {selectedContact && (
          <div className="contact-detail-panel">
            <div className="panel-header">
              <div>
                <h2>{selectedContact.first_name} {selectedContact.last_name}</h2>
                {selectedContact.title && (
                  <p className="panel-subtitle">{selectedContact.title}</p>
                )}
              </div>
              <button className="close-panel" onClick={() => setSelectedContact(null)}>×</button>
            </div>

            <div className="panel-content">
              {/* Contact Information */}
              <div className="detail-section">
                <h3>Contact Information</h3>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">Email</span>
                    <a href={`mailto:${selectedContact.email}`}>{selectedContact.email}</a>
                  </div>
                  {selectedContact.phone && (
                    <div className="detail-item">
                      <span className="detail-label">Phone</span>
                      <a href={`tel:${selectedContact.phone}`}>{selectedContact.phone}</a>
                    </div>
                  )}

                  {/* 1. Company — clickable, navigates to account page */}
                  {selectedContact.account && (
                    <div className="detail-item">
                      <span className="detail-label">Company</span>
                      <span
                        className="detail-value--link"
                        onClick={() => navigateToAccount(selectedContact.account_id || selectedContact.account.id)}
                        title="Open company page"
                      >
                        {selectedContact.account.name} →
                      </span>
                    </div>
                  )}

                  {selectedContact.role_type && (
                    <div className="detail-item">
                      <span className="detail-label">Role Type</span>
                      <span className={`detail-badge role-${selectedContact.role_type}`}>
                        {selectedContact.role_type.replace('_', ' ')}
                      </span>
                    </div>
                  )}
                  <div className="detail-item">
                    <span className="detail-label">Engagement</span>
                    <span className={`detail-badge engagement-${selectedContact.engagement_level}`}>
                      {selectedContact.engagement_level} engagement
                    </span>
                  </div>
                  {selectedContact.location && (
                    <div className="detail-item">
                      <span className="detail-label">Location</span>
                      <span>{selectedContact.location}</span>
                    </div>
                  )}
                  {selectedContact.linkedin_url && (
                    <div className="detail-item">
                      <span className="detail-label">LinkedIn</span>
                      <a href={selectedContact.linkedin_url} target="_blank" rel="noopener noreferrer">
                        View Profile →
                      </a>
                    </div>
                  )}
                  {selectedContact.last_contact_date && (
                    <div className="detail-item">
                      <span className="detail-label">Last Contact</span>
                      <span>{new Date(selectedContact.last_contact_date).toLocaleDateString()}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* 2. Related Deals — from deal_contacts table */}
              <div className="detail-section">
                <h3>Related Deals ({getLinkedDeals(selectedContact).length})</h3>
                {getLinkedDeals(selectedContact).length === 0 ? (
                  <p className="empty-message">No deal roles assigned to this contact</p>
                ) : (
                  <div className="linked-items-list">
                    {getLinkedDeals(selectedContact).map(deal => (
                      <div
                        key={deal.id}
                        className="linked-item linked-item--clickable"
                        onClick={() => navigateToDeal(deal.id)}
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

                {/* Unlinked account deals — suggestion banner */}
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

              {/* 3. Email Activity */}
              <div className="detail-section">
                <h3>Email Activity ({getContactEmails(selectedContact.id).length})</h3>
                {getContactEmails(selectedContact.id).length === 0 ? (
                  <p className="empty-message">No email history</p>
                ) : (
                  <div className="linked-items-list">
                    {getContactEmails(selectedContact.id).slice(0, 10).map(email => (
                      <div key={email.id} className="linked-item">
                        <span className="item-icon">
                          {email.direction === 'sent' ? '📤' : '📥'}
                        </span>
                        <div className="item-info">
                          <div className="item-name">{email.subject || '(No subject)'}</div>
                          <div className="item-meta">
                            {new Date(email.sent_at).toLocaleDateString(undefined, {
                              month: 'short', day: 'numeric', year: 'numeric',
                              hour: '2-digit', minute: '2-digit'
                            })}
                            {email.direction === 'sent' && email.opened_at && ' · Opened'}
                            {email.deal_id && (() => {
                              const deal = deals.find(d => d.id === email.deal_id);
                              return deal ? ` · ${deal.name}` : '';
                            })()}
                          </div>
                        </div>
                      </div>
                    ))}
                    {getContactEmails(selectedContact.id).length > 10 && (
                      <div className="show-more-hint">
                        +{getContactEmails(selectedContact.id).length - 10} more emails
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 4. Meetings */}
              <div className="detail-section">
                <h3>Meetings ({getContactMeetings(selectedContact.id).length})</h3>
                {getContactMeetings(selectedContact.id).length === 0 ? (
                  <p className="empty-message">No meetings on record</p>
                ) : (
                  <div className="linked-items-list">
                    {getContactMeetings(selectedContact.id).map(meeting => {
                      const isPast = new Date(meeting.start_time) < new Date();
                      return (
                        <div
                          key={meeting.id}
                          className="linked-item linked-item--clickable"
                          onClick={() => navigateToMeeting(meeting.id)}
                          title="View in Calendar"
                        >
                          <span className="item-icon">
                            {isPast ? '✅' : '📅'}
                          </span>
                          <div className="item-info">
                            <div className="item-name">{meeting.title || 'Meeting'}</div>
                            <div className="item-meta">
                              {new Date(meeting.start_time).toLocaleDateString(undefined, {
                                month: 'short', day: 'numeric', year: 'numeric',
                                hour: '2-digit', minute: '2-digit'
                              })}
                              {' · '}
                              <span className={`meeting-status meeting-status--${meeting.status}`}>
                                {meeting.status}
                              </span>
                            </div>
                          </div>
                          <span className="item-arrow">→</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Quick Actions */}
              <div className="detail-section">
                <h3>Quick Actions</h3>
                <div className="quick-actions">
                  {/* 5. Send Email — opens EmailComposer */}
                  <button
                    className="btn-action"
                    onClick={() => openEmailComposer(selectedContact)}
                  >
                    ✉️ Send Email
                  </button>
                  {selectedContact.phone && (
                    <a href={`tel:${selectedContact.phone}`} className="btn-action">
                      📞 Call Contact
                    </a>
                  )}
                  {selectedContact.linkedin_url && (
                    <a
                      href={selectedContact.linkedin_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-action"
                    >
                      💼 View LinkedIn
                    </a>
                  )}
                  <button
                    className="btn-action"
                    onClick={() => {
                      setEditingContact(selectedContact);
                      setShowForm(true);
                    }}
                  >
                    ✏️ Edit Contact
                  </button>
                  <button
                    className="btn-action btn-action--danger"
                    onClick={() => handleDeleteContact(selectedContact.id)}
                  >
                    🗑️ Delete Contact
                  </button>
                </div>
              </div>

              {/* Notes */}
              {selectedContact.notes && (
                <div className="detail-section">
                  <h3>Notes</h3>
                  <p className="contact-notes-text">{selectedContact.notes}</p>
                </div>
              )}
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
          onClose={() => {
            setShowForm(false);
            setEditingContact(null);
          }}
        />
      )}

      {/* Email Composer Modal */}
      {showEmailComposer && (
        <EmailComposer
          contacts={contacts}
          deals={deals}
          prefill={emailComposerPrefill}
          onSubmit={handleSendEmail}
          onClose={() => {
            setShowEmailComposer(false);
            setEmailComposerPrefill(null);
          }}
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
    try {
      await onTag(dealId);
    } finally {
      setTaggingDealId(null);
    }
  };

  return (
    <div className="deal-suggestion-banner">
      <div className="deal-suggestion-header">
        <span className="deal-suggestion-icon">💡</span>
        <span className="deal-suggestion-text">
          {contact.account?.name || 'This account'} has {unlinkedDeals.length} open deal{unlinkedDeals.length !== 1 ? 's' : ''} where {contact.first_name} isn't linked
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
            <button
              className="btn-tag-deal"
              onClick={() => handleTag(deal.id)}
              disabled={taggingDealId === deal.id}
            >
              {taggingDealId === deal.id ? 'Linking…' : '+ Link'}
            </button>
          </div>
        ))}
      </div>

      <div className="deal-suggestion-dismiss">
        {!showSnoozeOptions ? (
          <button
            className="btn-dismiss-link"
            onClick={() => setShowSnoozeOptions(true)}
          >
            Dismiss
          </button>
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
    <div 
      className={`contact-card ${isSelected ? 'selected' : ''}`}
      onClick={onSelect}
    >
      <div className="contact-card-header">
        <div className="contact-avatar">
          {contact.first_name?.[0]}{contact.last_name?.[0]}
        </div>
        <div className="contact-actions">
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

      <h3 className="contact-name">
        {contact.first_name} {contact.last_name}
      </h3>
      
      {contact.title && (
        <p className="contact-title">{contact.title}</p>
      )}

      <p className="contact-company">{account.name}</p>

      <div className="contact-meta">
        <span className="contact-email">✉️ {contact.email}</span>
        {contact.phone && (
          <span className="contact-phone">📞 {contact.phone}</span>
        )}
      </div>

      {contact.role_type && (
        <div className={`contact-role role-${contact.role_type}`}>
          {contact.role_type.replace('_', ' ')}
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

export default ContactsView;
